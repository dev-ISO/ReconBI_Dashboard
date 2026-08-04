@REM This will build (if needed) and start your containers. To run them in detached mode, add the -d
docker-compose up -d

@REM To stop the running containers without removing them, use:
docker-compose stop

@REM To stop and remove all containers, networks, and optionally volumes defined in your Compose file, run
docker-compose down

@REM To ensure that the build process doesn’t use any cached layers, use:
docker-compose build --no-cache
