FROM flexprice:2.1.52
USER root
# The upstream runtime copies config/ but RBAC still resolves internal/config/.
RUN mkdir -p /app/internal && ln -s /app/config /app/internal/config
USER app
