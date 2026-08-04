# main.py
import os
from openpyxl import load_workbook
from fastapi import FastAPI, Request
from Modules.utility_operations import process_all_tables
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime

app = FastAPI()

# -----------------------------------
# CORS configuration
# -----------------------------------
origins = [
    "http://localhost:3000",   # or your React app port
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    # add more domains as needed...
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_credentials=True,
    allow_methods=["*"],      
    allow_headers=["*"],      
)

# -----------------------------------
# Logging middleware
# -----------------------------------
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """
    Middleware that logs each incoming request to a file named by the current date.
    Includes IP address and port, HTTP method, requested URL, and timestamp.
    """
    # Create a "logs" folder if it doesn't exist
    os.makedirs("logs", exist_ok=True)

    # Name the log file based on the current date
    current_date = datetime.now().strftime("%Y-%m-%d")
    log_file_path = f"logs/{current_date}.log"

    # Gather request information
    method = request.method
    url = str(request.url)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Retrieve client IP and port, prioritizing X-Forwarded-For if available.
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        # Take the first IP in the list (may contain multiple IPs if passed through multiple proxies)
        client_ip = x_forwarded_for.split(",")[0].strip()
        # Port info is typically not forwarded, so we keep the original port if available.
        client_port = request.client.port if request.client is not None else "Unknown"
    elif request.client is not None:
        client_ip = request.client.host
        client_port = request.client.port
    else:
        client_ip = "Unknown"
        client_port = "Unknown"

    # Write to the log file (append mode)
    with open(log_file_path, "a", encoding="utf-8") as log_file:
        log_line = (
            f"{timestamp} - {method} {url} "
            f"- IP: {client_ip}:{client_port}\n"
        )
        log_file.write(log_line)

    # Process the request
    response = await call_next(request)
    return response



@app.get("/")
async def root():
    return {"message": "Hello World"}


# Adjust the path to your Excel file as needed:
excel_file_path = os.path.join(
    os.path.dirname(__file__),
    "Excel/Grp_Resource.xlsx"
)

workbook = load_workbook(filename=excel_file_path, data_only=True)
sheet_name = "Resource"
sheet = workbook[sheet_name]

# Parse all data (tables) starting at col "CW"
all_data = process_all_tables(sheet, "D")

# Add a "resourceID" field derived from row.resource
# E.g. "3000E  Mech/Pipe - Engr" => resourceID = "3000E"
for row in all_data:
    resource_trimmed = row["resource"].strip()
    split_arr = resource_trimmed.split()
    resource_id = split_arr[0] if split_arr else resource_trimmed
    row["resourceID"] = resource_id

print(f"Parsed {len(all_data)} rows of data from Excel.")



@app.get("/api/offices")
def get_offices():
    """
    1) GET all offices
    """
    offices = sorted(list(set(row["office"] for row in all_data)))
    return offices



@app.get("/api/resources")
def get_resources():
    """
    2) GET all resource IDs
    """
    resource_ids = sorted(list(set(row["resourceID"] for row in all_data)))
    return resource_ids



@app.get("/api/data/offices/{office_id}")
def get_data_by_office(office_id: str):
    """
    3) GET data for a specific office only
       e.g. /api/data/offices/10
    """
    filtered = [row for row in all_data if row["office"] == office_id]
    return filtered



@app.get("/api/data/resources/{resource_id}")
def get_data_by_resource(resource_id: str):
    """
    4) GET data for a specific resource ID only
       e.g. /api/data/resources/3000E
    """
    filtered = [row for row in all_data if row["resourceID"] == resource_id]
    return filtered



# @app.get("/api/data/offices/{office_id}/resources/{resource_id}")
# def get_data_office_resource(office_id: str, resource_id: str):
#     """
#     5) GET data for a specific office AND resource ID
#        e.g. /api/data/offices/10/resources/3000E
#     """
#     filtered = [
#         row
#         for row in all_data
#         if row["office"] == office_id and row["resourceID"] == resource_id.strip()
#     ]
#     return filtered

# @app.get("/api/data/offices/{office_id}/resources/{resource_id}/date/{date}")
# def get_data_office_resource_date(office_id: str, resource_id: str, date: str):
#     """
#     6) GET data for office + resource + date
#        e.g. /api/data/offices/10/resources/3000E/date/2025-01-12
#     """
#     filtered = [
#         row
#         for row in all_data
#         if row["office"] == office_id and row["resourceID"] == resource_id
#     ]

#     # Return only rows that contain the date in row.data
#     matched = []
#     for row in filtered:
#         has_date = any(entry["date"] == date for entry in row["data"])
#         if has_date:
#             matched.append(row)

#     return matched



@app.get("/api/data/offices/{office_id}/resources/{resource_id}")
def get_data_office_resource(office_id: str, resource_id: str):
    """
    5) GET data for a specific office AND resource ID
       e.g. /api/data/offices/10/resources/3000E

       If office_id == "ALL", return data for all offices for the given resource ID.
    """
    filtered = [
        row
        for row in all_data
        # Only filter on row['office'] if office_id is NOT "ALL"
        if (office_id == "ALL" or row["office"] == office_id)
        and row["resourceID"] == resource_id.strip()
    ]
    return filtered



@app.get("/api/data/offices/{office_id}/resources/{resource_id}/date/{date}")
def get_data_office_resource_date(office_id: str, resource_id: str, date: str):
    """
    6) GET data for office + resource + date
       e.g. /api/data/offices/10/resources/3000E/date/2025-01-12

       If office_id == "ALL", return data for all offices for the given resource ID 
       and date.
    """
    # First, filter by office (if not ALL) and resource:
    filtered = [
        row
        for row in all_data
        if (str(office_id).lower() == "all" or row["office"] == office_id)
        and row["resourceID"] == resource_id.strip()
    ]

    # Then, narrow down to those rows that have the specified date in row["data"]:
    matched = []
    for row in filtered:
        has_date = any(entry["date"] == date for entry in row["data"])
        if has_date:
            matched.append(row)

    return matched


