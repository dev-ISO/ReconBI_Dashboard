# Build context = backend/ (see docker-compose.yml). Mirrors the PSV host's
# 3-stage shape: build -> final (api), plus a migrator stage running the rcd_
# EF migrations bundle (never auto-migrate at startup).

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY nuget.config Directory.Build.props ./
COPY src/ReconDashboards.Core/ReconDashboards.Core.csproj src/ReconDashboards.Core/
COPY src/ReconDashboards.Postgres/ReconDashboards.Postgres.csproj src/ReconDashboards.Postgres/
COPY src/ReconDashboards.AspNetCore/ReconDashboards.AspNetCore.csproj src/ReconDashboards.AspNetCore/
COPY demo/ReconDashboards.DemoHost/ReconDashboards.DemoHost.csproj demo/ReconDashboards.DemoHost/
RUN dotnet restore demo/ReconDashboards.DemoHost/ReconDashboards.DemoHost.csproj

COPY src/ src/
COPY demo/ demo/
RUN dotnet publish demo/ReconDashboards.DemoHost/ReconDashboards.DemoHost.csproj -c Release -o /app/publish

# EF migrations bundle for the rcd_ tables (self-contained CLI, applied by the
# compose "migrate" profile).
RUN dotnet tool install --global dotnet-ef --version "10.*" \
 && export PATH="$PATH:/root/.dotnet/tools" \
 && dotnet ef migrations bundle \
      --project src/ReconDashboards.Postgres \
      --startup-project src/ReconDashboards.Postgres \
      --context ReconDashboardsDbContext \
      --configuration Release \
      --target-runtime linux-x64 \
      --output /app/efbundle-rcd \
      --force

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "ReconDashboards.DemoHost.dll"]

FROM mcr.microsoft.com/dotnet/runtime-deps:10.0 AS migrator
WORKDIR /app
COPY --from=build /app/efbundle-rcd .
# RCD_MIGRATIONS_CONNECTION is read by the bundle via --connection.
ENTRYPOINT ["/bin/sh", "-c", "./efbundle-rcd --connection \"$RCD_MIGRATIONS_CONNECTION\""]
