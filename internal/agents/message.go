package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
)

// ParamsInterceptor adds service parameters, sent as HTTP headers or gRPC
// metadata, and a tenant to every call of a client.
type ParamsInterceptor struct {
	a2aclient.PassthroughInterceptor
	// Params is called before every call, so environment variables are read
	// when the call is made.
	Params func() (a2aclient.ServiceParams, error)
	// Tenant, if set, replaces the interface's tenant.
	Tenant string
}

// Before implements a2aclient.CallInterceptor.
func (p *ParamsInterceptor) Before(ctx context.Context, req *a2aclient.Request) (context.Context, any, error) {
	if p.Params != nil {
		params, err := p.Params()
		if err != nil {
			return ctx, nil, err
		}
		for k, vals := range params {
			req.ServiceParams.Append(k, vals...)
		}
	}
	if p.Tenant != "" {
		if r, ok := req.Payload.(*a2a.SendMessageRequest); ok {
			r.Tenant = p.Tenant
		}
	}
	return ctx, nil, nil
}

// Compose is a message as the user wrote it in the inspector.
type Compose struct {
	Text        string          `json:"text"`
	Attachments []Attachment    `json:"attachments,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	Metadata    map[string]any  `json:"metadata,omitempty"`
	Extensions  []string        `json:"extensions,omitempty"`
}

// Attachment is a file sent with a message, either inline or by URL.
type Attachment struct {
	Name      string `json:"name,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	// Bytes is base64 in JSON.
	Bytes []byte `json:"bytes,omitempty"`
	URL   string `json:"url,omitempty"`
}

// Message builds the user message for c.
func (c Compose) Message() (*a2a.Message, error) {
	var parts []*a2a.Part
	if c.Text != "" {
		parts = append(parts, a2a.NewTextPart(c.Text))
	}
	for i, att := range c.Attachments {
		var p *a2a.Part
		switch {
		case att.URL != "" && att.Bytes != nil:
			return nil, fmt.Errorf("attachment %d has both bytes and a URL", i+1)
		case att.URL == "" && len(att.Bytes) == 0:
			return nil, fmt.Errorf("attachment %d is empty", i+1)
		case att.URL != "":
			p = a2a.NewFileURLPart(a2a.URL(att.URL), att.MediaType)
		default:
			p = a2a.NewRawPart(att.Bytes)
			p.MediaType = att.MediaType
		}
		p.Filename = att.Name
		parts = append(parts, p)
	}
	if len(c.Data) > 0 && string(c.Data) != "null" {
		var v any
		if err := json.Unmarshal(c.Data, &v); err != nil {
			return nil, fmt.Errorf("the data part isn't valid JSON: %w", err)
		}
		parts = append(parts, a2a.NewDataPart(v))
	}
	if len(parts) == 0 {
		return nil, errors.New("the message is empty: add text, an attachment or data")
	}
	msg := a2a.NewMessage(a2a.MessageRoleUser, parts...)
	msg.Metadata = c.Metadata
	msg.Extensions = c.Extensions
	return msg, nil
}
