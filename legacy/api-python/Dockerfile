# Use an official lightweight Python image
FROM python:3.12.9-slim

# Set the working directory in the container.
WORKDIR /app

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your application code
COPY . .

# Start the FastAPI application using Uvicorn.
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000", "--reload"]