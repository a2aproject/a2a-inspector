// Copyright 2026 The A2A Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package traffic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/v03spec"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// DialOptions returns the gRPC dial options that record calls in the log.
func (l *Log) DialOptions() []grpc.DialOption {
	return []grpc.DialOption{
		grpc.WithChainUnaryInterceptor(l.unaryInterceptor),
		grpc.WithChainStreamInterceptor(l.streamInterceptor),
		grpc.WithUserAgent(UserAgent),
	}
}

func (l *Log) startGRPC(ctx context.Context, cc *grpc.ClientConn, method string) (string, *Call) {
	call := CallFrom(ctx)
	md, _ := metadata.FromOutgoingContext(ctx)
	id := l.add(&Entry{
		ConnectionID: call.ConnectionID,
		GRPC: &GRPCExchange{
			Target:     cc.Target(),
			FullMethod: method,
			Metadata:   maskMetadata(md, call.Secrets),
			Messages:   []GRPCMessage{},
		},
	})
	call.addEntry(id)
	return id, call
}

func (l *Log) unaryInterceptor(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	id, call := l.startGRPC(ctx, cc, method)
	if err := overrideMessage(req, call.MessageOverride); err != nil {
		l.finish(id, err.Error(), nil)
		return err
	}
	l.addMessage(id, newMessage(true, req))

	var header, trailer metadata.MD
	err := invoker(ctx, method, req, reply, cc, append(opts, grpc.Header(&header), grpc.Trailer(&trailer))...)
	if err == nil {
		m := newMessage(false, reply)
		l.addMessage(id, m)
		call.message(id, m)
	}
	l.finishGRPC(id, call, err, header, trailer)
	return err
}

func (l *Log) finishGRPC(id string, call *Call, err error, header, trailer metadata.MD) {
	st := status.Convert(err)
	l.finish(id, "", func(e *Entry) {
		e.GRPC.Headers = maskMetadata(header, call.Secrets)
		e.GRPC.Trailers = maskMetadata(trailer, call.Secrets)
		e.GRPC.StatusCode = st.Code().String()
		e.GRPC.StatusMessage = st.Message()
	})
}

func (l *Log) streamInterceptor(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
	id, call := l.startGRPC(ctx, cc, method)
	cs, err := streamer(ctx, desc, cc, method, opts...)
	if err != nil {
		l.finishGRPC(id, call, err, nil, nil)
		return nil, err
	}
	s := &recordingStream{ClientStream: cs, log: l, id: id, call: call}
	// a2a-go stops reading when its caller stops; the call's context ending
	// is then the only sign the stream is over.
	go func() {
		<-ctx.Done()
		s.end(status.FromContextError(ctx.Err()).Err())
	}()
	return s, nil
}

type recordingStream struct {
	grpc.ClientStream
	log  *Log
	id   string
	call *Call
	once sync.Once
}

func (s *recordingStream) SendMsg(m any) error {
	if err := overrideMessage(m, s.call.MessageOverride); err != nil {
		s.end(status.Error(codes.InvalidArgument, err.Error()))
		return err
	}
	s.log.addMessage(s.id, newMessage(true, m))
	return s.ClientStream.SendMsg(m)
}

func (s *recordingStream) RecvMsg(m any) error {
	err := s.ClientStream.RecvMsg(m)
	switch {
	case err == nil:
		msg := newMessage(false, m)
		s.log.addMessage(s.id, msg)
		s.call.message(s.id, msg)
	case errors.Is(err, io.EOF):
		s.end(nil)
	default:
		s.end(err)
	}
	return err
}

func (s *recordingStream) end(err error) {
	s.once.Do(func() {
		var header, trailer metadata.MD
		// After the stream ended or the server failed it, the headers and
		// trailers are there; a stream the client canceled may have neither.
		if code := status.Code(err); code != codes.Canceled && code != codes.DeadlineExceeded {
			header, _ = s.ClientStream.Header()
			trailer = s.ClientStream.Trailer()
		}
		s.log.finishGRPC(s.id, s.call, err, header, trailer)
	})
}

func newMessage(fromClient bool, m any) GRPCMessage {
	msg := GRPCMessage{FromClient: fromClient, Time: time.Now()}
	if pm, ok := m.(proto.Message); ok {
		if b, err := protojson.Marshal(pm); err == nil {
			msg.JSON = v03spec.ToSpec(pm.ProtoReflect().Descriptor(), b)
		}
	}
	if msg.JSON == nil {
		msg.JSON = json.RawMessage("null")
	}
	return msg
}

// overrideMessage replaces the Message field of a SendMessageRequest, in the
// v1.0 (lf.a2a.v1) or v0.3 (a2a.v1) schema, with raw parsed as proto3 JSON.
func overrideMessage(req any, raw []byte) error {
	if raw == nil {
		return nil
	}
	pm, ok := req.(proto.Message)
	if !ok {
		return errors.New("the request isn't a protocol buffer message")
	}
	r := pm.ProtoReflect()
	fields := r.Descriptor().Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		if fd.Kind() != protoreflect.MessageKind || fd.IsList() || fd.Message().Name() != "Message" {
			continue
		}
		msg := r.NewField(fd).Message()
		if err := protojson.Unmarshal(v03spec.ToStub(fd.Message(), raw), msg.Interface()); err != nil {
			return fmt.Errorf("the raw message doesn't parse as %s: %w", fd.Message().FullName(), err)
		}
		r.Set(fd, protoreflect.ValueOfMessage(msg))
		return nil
	}
	return fmt.Errorf("%s has no message to replace", r.Descriptor().FullName())
}
