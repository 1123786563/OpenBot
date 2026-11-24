FROM python:3.13-alpine
WORKDIR /app
COPY account_status.py .
ENTRYPOINT ["python", "-B", "account_status.py"]
CMD ["serve"]
