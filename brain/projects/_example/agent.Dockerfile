# Example of a project's agent image: copy this folder to <PROJECTS_DIR>/<name>/ on the box (default /opt/factory/projects).
# It extends the general factory agent image (Node, Python + uv, Postgres + pgvector, Chromium).
FROM factory-agent:latest
# install packages as root
USER root
# add what this project's tests need (made-up example: an HTTP client library for Python)
RUN pip3 install -q --break-system-packages httpx
# agents run as the unprivileged user
USER agent
