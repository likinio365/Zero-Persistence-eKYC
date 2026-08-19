FROM golang:1.21-alpine AS builder
WORKDIR /chaincode
COPY go.mod go.sum ./
COPY vendor ./vendor
COPY *.go ./
RUN go build -mod=vendor -o kyccc .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /chaincode
COPY --from=builder /chaincode/kyccc .
EXPOSE 7052
CMD ["./kyccc"]
