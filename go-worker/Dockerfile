# Multi-stage build for the Go write-back relay.
#
# Stage 1 compiles the binary; stage 2 is a tiny runtime image that contains
# ONLY the binary. Because the worker uses the pure-Go SQLite driver
# (modernc.org/sqlite), we can build with CGO_ENABLED=0 to get a fully static
# binary — no libc, no shared libraries — which is why the runtime image can be
# so small. (This is the payoff of the driver choice made back in M1.)

# --- build stage ---
FROM golang:1.26-alpine AS build
WORKDIR /src

# Download dependencies first, in their own layer, so they are cached and not
# re-downloaded every time only the source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /worker .

# --- runtime stage ---
FROM alpine:3.20
# ca-certificates so the worker can make TLS calls (e.g. real Shopify/Etsy).
RUN apk add --no-cache ca-certificates
COPY --from=build /worker /usr/local/bin/worker

# Default mode; override with `-mode=relay|consumer|audit` in compose / ECS.
ENTRYPOINT ["worker"]
CMD ["-mode=consumer"]
