// app/api/proxy/route.ts
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const officeId = searchParams.get('officeId');
  const resourceId = searchParams.get('resourceId');

  if (!officeId || !resourceId) {
    return NextResponse.json({ error: 'Missing officeId or resourceId' }, { status: 400 });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL; // e.g., "http://api"
  const apiPort = process.env.NEXT_PUBLIC_API_PORT; // e.g., "5000"

  if (!apiUrl || !apiPort) {
    console.error('API configuration is missing:', { apiUrl, apiPort });
    return NextResponse.json({ error: 'API configuration is missing' }, { status: 500 });
  }

  // Build the target API URL.
  const targetUrl = `${apiUrl}:${apiPort}/api/data/offices/${officeId}/resources/${resourceId}`;
  console.log('Proxying request to:', targetUrl);

  // Attempt to get the original client IP:
  // 1. Try to read the X-Forwarded-For header (if any)
  // 2. Otherwise, fall back to the connection's client host.
  const originalIp =
    request.headers.get('x-forwarded-for') || (request.client ? request.client.host : 'Unknown');

  try {
    // Forward the request to the target API, including the X-Forwarded-For header.
    const response = await fetch(targetUrl, {
      headers: {
        'x-forwarded-for': originalIp,
      },
    });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching data from API:', error);
    return NextResponse.json({ error: 'Failed to fetch data from API' }, { status: 500 });
  }
}
