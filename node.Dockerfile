FROM node:20-slim

RUN useradd -m -u 1000 sandboxuser
WORKDIR /home/sandboxuser
USER sandboxuser

CMD ["node"]
