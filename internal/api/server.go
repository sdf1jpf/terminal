package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sdf1jpf/terminal/internal/customer"
	"github.com/sdf1jpf/terminal/internal/store"
)

// Server serves the customer API.
type Server struct {
	store *store.Store
	users map[string]string // userid -> password
	ttl   time.Duration

	mu       sync.Mutex
	sessions map[string]session
}

type session struct {
	user    string
	expires time.Time
}

// NewServer returns a server over st. Users maps upper-case userids to
// passwords.
func NewServer(st *store.Store, users map[string]string) *Server {
	return &Server{store: st, users: users, ttl: 8 * time.Hour, sessions: map[string]session{}}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /v1/session", s.logon)
	mux.HandleFunc("DELETE /v1/session", s.auth(s.logoff))
	mux.HandleFunc("GET /v1/customers", s.auth(s.list))
	mux.HandleFunc("POST /v1/customers", s.auth(s.create))
	mux.HandleFunc("GET /v1/customers/{id}", s.auth(s.get))
	mux.HandleFunc("PUT /v1/customers/{id}", s.auth(s.update))
	mux.HandleFunc("DELETE /v1/customers/{id}", s.auth(s.delete))
	return logRequests(mux)
}

type userKey struct{}

func userOf(r *http.Request) string { return r.Context().Value(userKey{}).(string) }

func bearer(r *http.Request) string {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return tok
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := bearer(r)
		s.mu.Lock()
		sess, ok := s.sessions[tok]
		if ok && time.Now().After(sess.expires) {
			delete(s.sessions, tok)
			ok = false
		}
		s.mu.Unlock()
		if !ok {
			writeError(w, http.StatusUnauthorized, codeUnauthorized, ErrUnauthorized.Error(), "")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, sess.user)))
	}
}

func (s *Server) logon(w http.ResponseWriter, r *http.Request) {
	var req LogonRequest
	if !readJSON(w, r, &req) {
		return
	}
	user := strings.ToUpper(strings.TrimSpace(req.UserID))
	want, ok := s.users[user]
	if !ok {
		want = "\x00" // still compare, so timing does not reveal valid userids
	}
	match := subtle.ConstantTimeCompare([]byte(want), []byte(strings.ToUpper(req.Password))) == 1
	if !ok || !match {
		writeError(w, http.StatusUnauthorized, codeBadLogon, ErrBadLogon.Error(), "")
		return
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "cannot create session", "")
		return
	}
	tok := hex.EncodeToString(b)
	exp := time.Now().Add(s.ttl)
	s.mu.Lock()
	for t, sess := range s.sessions { // sweep expired sessions
		if time.Now().After(sess.expires) {
			delete(s.sessions, t)
		}
	}
	s.sessions[tok] = session{user: user, expires: exp}
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, LogonResponse{Token: tok, UserID: user, ExpiresAt: exp.UTC()})
}

func (s *Server) logoff(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	delete(s.sessions, bearer(r))
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	list := s.store.List(r.URL.Query().Get("prefix"))
	if list == nil {
		list = []customer.Customer{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	c, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var c customer.Customer
	if !readJSON(w, r, &c) {
		return
	}
	if verr := customer.Validate(&c); verr != nil {
		writeError(w, http.StatusUnprocessableEntity, codeInvalid, verr.Message, verr.Field)
		return
	}
	c, err := s.store.Create(c, userOf(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) update(w http.ResponseWriter, r *http.Request) {
	var c customer.Customer
	if !readJSON(w, r, &c) {
		return
	}
	c.ID = r.PathValue("id")
	if verr := customer.Validate(&c); verr != nil {
		writeError(w, http.StatusUnprocessableEntity, codeInvalid, verr.Message, verr.Field)
		return
	}
	c, err := s.store.Update(c, userOf(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Delete(r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, ErrNotFound.Error(), "")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, codeConflict, ErrConflict.Error(), "")
	default:
		log.Printf("store error: %v", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "file error", "")
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid request body: "+err.Error(), "")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg, field string) {
	writeJSON(w, status, errorBody{errorDetail{Code: code, Message: msg, Field: field}})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Microsecond))
	})
}
