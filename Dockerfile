# Stage 1: build the UI.
FROM node:24-slim AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# Stage 2: build the binary, with the UI from stage 1 embedded.
FROM golang:1.26 AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY inspector/ inspector/
COPY internal/ internal/
COPY ui/embed.go ui/
COPY --from=ui /src/ui/dist ui/dist
# Without VERSION, the binary reports the release in inspector/version.go.
ARG VERSION
ARG COMMIT
RUN CGO_ENABLED=0 go build -trimpath -o /a2a-inspector \
    -ldflags="-s -w ${VERSION:+-X github.com/a2aproject/a2a-inspector/inspector.version=$VERSION} ${COMMIT:+-X github.com/a2aproject/a2a-inspector/inspector.commit=$COMMIT}" .

# Stage 3: run it.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=go /a2a-inspector /a2a-inspector
EXPOSE 8080
ENTRYPOINT ["/a2a-inspector", "--host", "0.0.0.0", "--port", "8080", "--no-open"]
