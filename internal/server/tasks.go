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

package server

import (
	"context"
	"fmt"
	"iter"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
)

// unaryCall is a non-streaming operation on a connection's agent.
type unaryCall struct {
	conn *connection
	// op is checked against the card's capabilities and the protocol version.
	op   validate.Operation
	kind validate.PayloadKind
	// webhook is the inspector's receiver the call's push config points to.
	webhook *webhookView
	// do calls the agent and returns what a2a-go decoded.
	do func(ctx context.Context) (any, error)
}

// unary runs a unary call and writes its result. Agent failures are part of
// the result; only the inspector's own errors are error responses.
func (s *Server) unary(w http.ResponseWriter, r *http.Request, uc unaryCall) {
	sess := sessionOf(r)
	conn := uc.conn
	tc, err := conn.call()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	release := conn.use()
	defer release()
	callCtx, stop := s.callContext(r)
	defer stop()
	ctx, cancel := context.WithTimeout(callCtx, sendTimeout)
	defer cancel()
	start := time.Now()
	decoded, err := uc.do(traffic.WithCall(ctx, tc))
	res := s.unaryResult(sess, conn, tc, start, uc.kind, decoded, err)
	res.Call.Findings = append(s.operationFindings(conn, uc.op), res.Call.Findings...)
	conn.settle(&res, false)
	res.Webhook = sess.hooks.drop(ctx, uc.webhook, res)
	writeJSON(w, http.StatusOK, res)
}

// taskPath splits the {task} segment into the task ID and a trailing verb
// such as "cancel". Task IDs can contain ":" too, so only the known verbs
// are split off.
func taskPath(r *http.Request, verbs ...string) (id, verb string) {
	id = r.PathValue("task")
	for _, v := range verbs {
		if base, ok := strings.CutSuffix(id, ":"+v); ok && base != "" {
			return base, v
		}
	}
	return id, ""
}

// queryInt reads an optional non-negative integer query parameter, or
// writes an error response.
func queryInt(w http.ResponseWriter, r *http.Request, name string) (*int, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return nil, true
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("%q must be a non-negative integer.", name))
		return nil, false
	}
	return &n, true
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	id, verb := taskPath(r, "subscribe")
	if verb == "subscribe" {
		req := &a2a.SubscribeToTaskRequest{ID: a2a.TaskID(id)}
		tc, err := conn.call()
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.streamEvents(w, r, streamCall{
			conn: conn,
			tc:   tc,
			op:   validate.SubscribeToTask,
			run: func(ctx context.Context) iter.Seq2[a2a.Event, error] {
				return conn.client.SubscribeToTask(ctx, req)
			},
		})
		return
	}
	historyLength, ok := queryInt(w, r, "historyLength")
	if !ok {
		return
	}
	req := &a2a.GetTaskRequest{ID: a2a.TaskID(id), HistoryLength: historyLength}
	s.unary(w, r, unaryCall{conn: conn, kind: validate.Task, do: func(ctx context.Context) (any, error) {
		task, err := conn.client.GetTask(ctx, req)
		if err != nil {
			return nil, err
		}
		return task, nil
	}})
}

func (s *Server) handleTaskAction(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	id, verb := taskPath(r, "cancel")
	if verb != "cancel" {
		writeError(w, http.StatusNotFound, "Unknown task operation; use :cancel.")
		return
	}
	req := &a2a.CancelTaskRequest{ID: a2a.TaskID(id)}
	s.unary(w, r, unaryCall{conn: conn, kind: validate.Task, do: func(ctx context.Context) (any, error) {
		task, err := conn.client.CancelTask(ctx, req)
		if err != nil {
			return nil, err
		}
		return task, nil
	}})
}

// parseTaskState accepts a state as v0.3 writes it, "input-required", or as
// a2a-go and ProtoJSON do, "TASK_STATE_INPUT_REQUIRED".
func parseTaskState(v string) (a2a.TaskState, bool) {
	name := strings.ReplaceAll(strings.TrimPrefix(strings.ToUpper(v), "TASK_STATE_"), "-", "_")
	switch state := a2a.TaskState("TASK_STATE_" + name); state {
	case a2a.TaskStateSubmitted, a2a.TaskStateWorking, a2a.TaskStateInputRequired, a2a.TaskStateAuthRequired,
		a2a.TaskStateCompleted, a2a.TaskStateCanceled, a2a.TaskStateFailed, a2a.TaskStateRejected:
		return state, true
	}
	return "", false
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	req := &a2a.ListTasksRequest{ContextID: q.Get("contextId"), PageToken: q.Get("pageToken")}
	if v := q.Get("status"); v != "" {
		if req.Status, ok = parseTaskState(v); !ok {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("Unknown task state %q.", v))
			return
		}
	}
	pageSize, ok := queryInt(w, r, "pageSize")
	if !ok {
		return
	}
	if pageSize != nil {
		req.PageSize = *pageSize
	}
	if req.HistoryLength, ok = queryInt(w, r, "historyLength"); !ok {
		return
	}
	s.unary(w, r, unaryCall{conn: conn, op: validate.ListTasks, kind: validate.ListTasksResponse, do: func(ctx context.Context) (any, error) {
		resp, err := conn.client.ListTasks(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp, nil
	}})
}

type pushConfigRequest struct {
	// ID, if set, is the config's ID; agents assign one otherwise.
	ID string `json:"id,omitempty"`
	// InspectorWebhook points the config to a new webhook of the inspector.
	InspectorWebhook bool `json:"inspectorWebhook,omitempty"`
	// External points the config to a URL the user gives.
	External *struct {
		URL             string `json:"url"`
		Token           string `json:"token,omitempty"`
		AuthScheme      string `json:"authScheme,omitempty"`
		AuthCredentials string `json:"authCredentials,omitempty"`
	} `json:"external,omitempty"`
}

func (s *Server) handleCreatePushConfig(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	var body pushConfigRequest
	if !decodeRequest(w, r, &body) {
		return
	}
	taskID := r.PathValue("task")
	cfg := &a2a.PushConfig{TaskID: a2a.TaskID(taskID), ID: body.ID}
	var view *webhookView
	switch {
	case body.InspectorWebhook == (body.External != nil):
		writeError(w, http.StatusBadRequest, `Give either "inspectorWebhook" or "external".`)
		return
	case body.InspectorWebhook && !s.webhooks():
		writeError(w, http.StatusBadRequest, errNoWebhooks)
		return
	case body.InspectorWebhook:
		wh, v := sessionOf(r).hooks.create(conn, taskID, s.webhookBaseURL())
		cfg.URL, cfg.Token, view = v.URL, wh.token, &v
	default:
		e := body.External
		if strings.TrimSpace(e.URL) == "" {
			writeError(w, http.StatusBadRequest, "The push notification config needs a URL.")
			return
		}
		cfg.URL, cfg.Token = strings.TrimSpace(e.URL), e.Token
		if e.AuthScheme != "" || e.AuthCredentials != "" {
			cfg.Auth = &a2a.PushAuthInfo{Scheme: e.AuthScheme, Credentials: e.AuthCredentials}
		}
	}
	s.unary(w, r, unaryCall{conn: conn, op: validate.CreateTaskPushNotificationConfig, kind: validate.TaskPushNotificationConfig, webhook: view,
		do: func(ctx context.Context) (any, error) {
			created, err := conn.client.CreateTaskPushConfig(ctx, cfg)
			if err != nil {
				return nil, err
			}
			return created, nil
		}})
}

func (s *Server) handleListPushConfigs(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	req := &a2a.ListTaskPushConfigRequest{TaskID: a2a.TaskID(r.PathValue("task"))}
	s.unary(w, r, unaryCall{conn: conn, op: validate.ListTaskPushNotificationConfigs, kind: validate.ListTaskPushNotificationConfigsResponse,
		do: func(ctx context.Context) (any, error) {
			configs, err := conn.client.ListTaskPushConfigs(ctx, req)
			if err != nil {
				return nil, err
			}
			return a2a.ListTaskPushConfigResponse{Configs: configs}, nil
		}})
}

func (s *Server) handleGetPushConfig(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	req := &a2a.GetTaskPushConfigRequest{TaskID: a2a.TaskID(r.PathValue("task")), ID: r.PathValue("config")}
	s.unary(w, r, unaryCall{conn: conn, op: validate.GetTaskPushNotificationConfig, kind: validate.TaskPushNotificationConfig,
		do: func(ctx context.Context) (any, error) {
			cfg, err := conn.client.GetTaskPushConfig(ctx, req)
			if err != nil {
				return nil, err
			}
			return cfg, nil
		}})
}

func (s *Server) handleDeletePushConfig(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	req := &a2a.DeleteTaskPushConfigRequest{TaskID: a2a.TaskID(r.PathValue("task")), ID: r.PathValue("config")}
	s.unary(w, r, unaryCall{conn: conn, op: validate.DeleteTaskPushNotificationConfig, kind: empty,
		do: func(ctx context.Context) (any, error) {
			if err := conn.client.DeleteTaskPushConfig(ctx, req); err != nil {
				return nil, err
			}
			sessionOf(r).hooks.configDeleted(conn.view.ID, string(req.TaskID))
			return struct{}{}, nil
		}})
}

func (s *Server) handleExtendedCard(w http.ResponseWriter, r *http.Request) {
	conn, ok := s.connection(w, r)
	if !ok {
		return
	}
	s.unary(w, r, unaryCall{conn: conn, op: validate.GetExtendedAgentCard, kind: extendedCard,
		do: func(ctx context.Context) (any, error) {
			card, err := conn.client.GetExtendedAgentCard(ctx, &a2a.GetExtendedAgentCardRequest{})
			if err != nil {
				return nil, err
			}
			return card, nil
		}})
}
