FROM python:3.12-slim

# TIER 3: a small, curated set of commonly-needed packages, baked in at
# build time — not arbitrary "pip install anything" per run, which would be
# slow and a real attack surface (installing packages needs network access,
# which this sandbox deliberately denies at runtime). Extend this list as
# real usage shows what people actually need.
RUN pip install --no-cache-dir requests numpy

RUN useradd -m -u 1000 sandboxuser
WORKDIR /home/sandboxuser
USER sandboxuser

CMD ["python3"]
