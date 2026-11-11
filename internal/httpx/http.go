// Package httpx contains the shared HTTP error and bounded JSON boundary.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

type Error struct {
	Status  int
	Message string
	Code    string
}

func (e *Error) Error() string              { return e.Message }
func Fail(status int, message string) error { return &Error{Status: status, Message: message} }
func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func Status(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return http.StatusInternalServerError
}
func WriteError(w http.ResponseWriter, err error) {
	JSON(w, Status(err), map[string]any{"error": err.Error()})
}
func ReadObject(r *http.Request, maximum int64) (map[string]any, error) {
	if r.Body == nil {
		return map[string]any{}, nil
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maximum {
		return nil, Fail(413, "Request body is too large")
	}
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, Fail(400, "Expected a JSON object")
	}
	return value, nil
}
func Text(value any, field string) (string, error) {
	s, ok := value.(string)
	if !ok || s == "" {
		return "", Fail(400, fmt.Sprintf("Invalid %s", field))
	}
	return s, nil
}
