package server

import (
	"net/http/httptest"
	"testing"
)

func TestReadinessIsNotLiveness(t *testing.T) {
	h := Health(func() bool { return false })
	for _, c := range []struct {
		path string
		code int
	}{
		{"/health/live", 200},
		{"/health/ready", 503},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", c.path, nil))
		if w.Code != c.code {
			t.Fatalf("%s: %d", c.path, w.Code)
		}
	}
}
