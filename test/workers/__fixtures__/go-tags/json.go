//go:build !jsoniter && !go_json

package tags

// Marshal is the default encoder.
func Marshal(v any) ([]byte, error) { return nil, nil }
