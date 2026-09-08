module example.com/docs-live-go

go 1.24

toolchain go1.24.12

require (
	github.com/foo/tiny-go v0.1.0
	github.com/gin-gonic/gin v1.12.0
)

require gopkg.in/yaml.v3 v3.0.1 // indirect

require (
	golang.org/x/text v0.34.0 // indirect
	k8s.io/api v0.0.0
)

replace k8s.io/api => ./staging/k8s.io/api

exclude github.com/linode/linodego v1.0.0

retract (
	[v2.0.0+incompatible, v2.0.7+incompatible] // Accidental.
)
