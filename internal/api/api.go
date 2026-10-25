// Package api is the terminal's client for the customer information REST
// API, which is served by the Cloudflare Worker in worker/.
//
//	GET    /v1/health
//	POST   /v1/session              logon: -> {"userid"}
//	GET    /v1/customers?prefix=X   list, ordered by name
//	POST   /v1/customers            create
//	GET    /v1/customers/{id}
//	PUT    /v1/customers/{id}       update; "version" must match
//	DELETE /v1/customers/{id}
//
// Everything except health is behind Cloudflare Access (see access.go).
// Errors are returned as {"error":{"code","message","field"}}.
package api

import "errors"

var (
	ErrUnauthorized = errors.New("not logged on or session expired")
	ErrBadLogon     = errors.New("not authorized by Cloudflare Access")
	ErrNotFound     = errors.New("record not found")
	ErrConflict     = errors.New("record was changed by another user")
	ErrUnavailable  = errors.New("host not responding")
)

// Wire types and error codes; keep in step with worker/src.

type LogonResponse struct {
	UserID string `json:"userid"`
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

// Error codes used on the wire.
const (
	codeUnauthorized = "unauthorized"
	codeNotFound     = "not_found"
	codeConflict     = "conflict"
	codeInvalid      = "invalid"
)
