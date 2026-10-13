# The Go runtime candidate's container image: one static binary, one expert
# instruction file, nothing else. Multi-stage so the toolchain never ships.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/runtime ./cmd/runtime

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/runtime /runtime
COPY experts/ /experts/
# Flags come from the compose file / orchestrator; the credential and the model
# credential arrive through the environment (runtimeconfig/config.go).
ENTRYPOINT ["/runtime"]
