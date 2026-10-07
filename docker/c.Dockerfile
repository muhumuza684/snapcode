FROM gcc:13-bookworm
RUN useradd -m sandboxuser
WORKDIR /home/sandboxuser
USER sandboxuser
CMD ["gcc"]
