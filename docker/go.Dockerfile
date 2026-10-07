FROM golang:1.22-bookworm

# No fixed UID — golang:bookworm may or may not pre-create a UID 1000 user;
# let useradd pick a free one (same lesson learned from the Node image).
RUN useradd -m sandboxuser
WORKDIR /home/sandboxuser
USER sandboxuser

# `go run` compiles and executes in one step — same single-command shape as
# python3/node, no separate compile phase to manage.
CMD ["go"]
