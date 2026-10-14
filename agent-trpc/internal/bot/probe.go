package bot

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// ProbeHealth answers whether GET url returns 200 within the timeout — the
// body the binary's -healthcheck mode turns into an exit code, so a
// distroless image can still tell compose whether the Bot is serving.
func ProbeHealth(ctx context.Context, url string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("health endpoint answered %d", res.StatusCode)
	}
	return nil
}
