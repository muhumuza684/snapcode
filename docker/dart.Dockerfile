FROM dart:stable

# No fixed UID here — the node:slim image taught us fixed UIDs can collide
# with a base image's own pre-created user. Let useradd pick a free one.
RUN useradd -m sandboxuser
WORKDIR /home/sandboxuser
USER sandboxuser

CMD ["dart"]
