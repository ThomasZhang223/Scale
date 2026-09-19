FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The service itself.
COPY app ./app

# The catalogue tooling. The image used to hold app/ and nothing else, which made the
# container able to answer /crawl and /extract but unable to *run a catalogue* — the merchant
# list, the driver and the loader all lived outside it, so a mass ingest meant a second Python
# environment on the host with its own copy of these dependencies.
#
# These are small and text-only (the driver, the loader, the identity rule they share, the
# verified merchant list). They are build inputs to a catalogue run, not to serving traffic, so
# they cost a few kilobytes of image and save an entire parallel setup:
#
#   docker compose --profile local exec ingest \
#     python3 bulk_ingest.py merchants.verified.json --base http://localhost:8080 --out /data/.bulk
#
# Deliberately NOT copied: prebake/ (100 images, ~30 MB — it is an input to load_catalog.py that
# belongs on the host, and moves to R2 anyway), tests/, samples/ and the page cache. See
# .dockerignore, which keeps them out of the build context entirely.
COPY bulk_ingest.py load_catalog.py verify_merchants.py ./
COPY merchants.verified.json ./

# Where a catalogue run writes. Mount a host directory over it (see compose.ingest.yml) or the
# output dies with the container — which is the wrong way to discover that after a 20-merchant
# run.
VOLUME ["/data"]

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
