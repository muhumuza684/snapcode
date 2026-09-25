FROM python:3.12-slim

# No network access needed inside the sandbox image build beyond this step
RUN useradd -m -u 1000 sandboxuser
WORKDIR /home/sandboxuser
USER sandboxuser

# The orchestrator overrides CMD per run with the actual user code
CMD ["python3"]
