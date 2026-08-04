/* eslint-disable @typescript-eslint/no-explicit-any */
// components/SideMenu.tsx
"use client";

import React, { useState, useEffect } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mergeResourceData } from "@/utils/mergeResourceData";
import { useTheme } from "next-themes";
// import { ChartConfig } from "@/types/chart-config"; 
// ^ define your ChartConfig interface somewhere (like in a types folder)

interface SideMenuProps {
  onCreateChart: (config: ChartConfig) => void;
}

export interface ChartConfig {
  id: string; // unique ID for the chart
  chartType: string;
  officeId: string;
  resourceId?: string;
  startDate?: string;
  endDate?: string;
  mergedData: any[];
  resourceIDs: string[];
}

export function SideMenu({ onCreateChart }: SideMenuProps) {
  const [open, setOpen] = useState(false);
  const [chartType, setChartType] = useState("Line");
  const [officeId, setOfficeId] = useState("");
  const [resourceIdInput, setResourceIdInput] = useState(""); // typed by user
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(false);

  const { resolvedTheme } = useTheme();
  const [ mounted, setMounted ] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted)
  {
      return null;
  }

  // Adjust to your environment or store in env
  // const api_url = "192.168.50.167";
  // const api_url = "0.0.0.0";
  const api_url = process.env.API_URL;
  const api_port = process.env.API_PORT;

  /**
   * Parse the user's input for resource IDs. We do two levels:
   *  1) Split by commas => separate lines in the chart
   *  2) Within each comma split, split by '+' => combined line
   *
   * Examples:
   *  "6000D" => [ ["6000D"] ]
   *  "6000D,6000E" => [ ["6000D"], ["6000E"] ] (two lines)
   *  "6000D + 6000E" => [ ["6000D","6000E"] ] (sum them into one line)
   *  "6000D+6000E,7000F" => [ ["6000D","6000E"], ["7000F"] ]
   */
  function parseResourceInput(value: string): string[][] {
    // Split by comma to get groups
    const commaGroups = value.split(",").map((s) => s.trim()).filter(Boolean);
    // For each group, split by '+'
    const parsed: string[][] = commaGroups.map((group) => {
      return group
        .split("+")
        .map((r) => r.trim())
        .filter(Boolean);
    });
    return parsed;
  }

  // /**
  //  * Fetch data for a single resource from the server
  //  */
  // async function fetchDataForResource(resourceId: string) {
  //   // const url = `http://${api_url}:${api_port}/api/data/offices/${officeId}/resources/${resourceId}`;
  //   const url = `http://localhost:5000/api/data/offices/${officeId}/resources/${resourceId}`;
  //   console.log(url)

  //   // If resourceId is empty, you might use the "all resources" URL:
  //   // But here we'll assume user won't do an empty resource if using plus.

  //   const response = await axios.get(url);
  //   const dataArray = Array.isArray(response.data) ? response.data : [];
  //   return dataArray; // e.g. same format as your existing "[ {office, resource, resourceID, data: [...] } ]"
  // }

  /**
   * Fetch data for a single resource from the server via a Next.js proxy.
   */
  async function fetchDataForResource(resourceId: string) {
    // Build the proxy URL using query parameters.
    // const api_url = process.env.NEXT_PUBLIC_API_URL;
    // const api_port = process.env.NEXT_PUBLIC_API_PORT;

    const url = `/api/proxy?officeId=${encodeURIComponent(officeId)}&resourceId=${encodeURIComponent(resourceId)}`;
    // const url = `http://${process.env.NEXT_PUBLIC_API_URL}:${process.env.NEXT_PUBLIC_API_PORT}/api/data/offices/${officeId}/resources/${resourceId}`;
    console.log('Fetching data from endpoint:', url);

    try {
      const response = await axios.get(url);
      const dataArray = Array.isArray(response.data) ? response.data : [];
      return dataArray;
    } catch (error) {
      console.error('Error fetching resource data:', error);
      throw error;
    }
  }


  /**
   * Summation logic for resources in a "plus" group.
   * If user typed "6000D + 6000E", we fetch them individually, then sum them by date.
   * Return a single "combined" item in the same shape as the normal server response.
   */
  function combineResourceArrays(itemsArray: any[][], combinedResourceId: string): any {
    // Example of itemsArray: [ [ {office, resource, resourceID, data}, ... ], [ ...another resource array...] ]
    // Flatten into one array, but we want to sum the "data" arrays that share the same date.

    // We'll gather office info from the first, but you might prefer to merge them if they differ
    const office = itemsArray[0]?.[0]?.office ?? "";
    // We'll store combined data in a dateMap
    const dateMap: Record<string, number> = {};
    const combinedResourceNames = [];

    for (const arr of itemsArray) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      // Usually each arr is length 1 or so, but let's loop anyway
      const item = arr[0];
      combinedResourceNames.push(item.resource);
      // Now item.data is the date-value pairs
      item.data.forEach((entry: { date: string; value: number }) => {
        if (!dateMap[entry.date]) {
          dateMap[entry.date] = 0;
        }
        dateMap[entry.date] += entry.value;
      });
    }

    // Build the final "summed" data array
    const summedData = Object.keys(dateMap).sort().map((date) => {
      return { date, value: dateMap[date] };
    });

    return {
      office,
      resource: combinedResourceNames.join(" + ") + " (COMBINED)", 
      resourceID: combinedResourceId, 
      data: summedData,
    };
  }

  /**
   * Main handler for "Create" button
   * 1) Parse input => get array-of-arrays for resources
   * 2) For each array, if there's more than one resource => sum them
   * 3) Merge all into a single array for "multiple lines" in one chart
   */
  async function handleCreate() {
    if (!officeId) return;
    setLoading(true);

    try {
      // e.g. "6000D+6000E,7000F" => [ ["6000D","6000E"], ["7000F"] ]
      const resourceGroups = parseResourceInput(resourceIdInput);

      const finalItems: any[] = [];
      // For each group => fetch data for each resource => if multiple => sum
      for (const group of resourceGroups) {
        if (group.length === 1) {
          // Single resource => fetch it normally
          const singleId = group[0];
          const response = await fetchDataForResource(singleId);
          // response is an array in your server format
          // e.g. [ {office, resource, resourceID, data: [...] } ]
          finalItems.push(...response);
        } else if (group.length > 1) {
          // e.g. user typed "6000D + 6000E"
          // 1) fetch each resource
          const promises = group.map((resId) => fetchDataForResource(resId));
          const results = await Promise.all(promises);
          // results is an array-of-arrays => e.g. [ [ {office, resource, data} ], [ {office, resource, data} ] ]
          // 2) sum them into one
          const combinedId = group.join("+"); // e.g. "6000D+6000E"
          const combinedItem = combineResourceArrays(results, combinedId);
          // push the combined item
          finalItems.push(combinedItem);
        }
      }

      // If nothing was returned, you can bail
      if (finalItems.length === 0) {
        console.warn("No data returned from server.");
        return;
      }

      // Merge all items into date-based structure
      // This merges resource IDs into separate lines (unless we already combined them).
      const { mergedData, resourceIDs } = mergeResourceData(finalItems);

      // Chart ID + final config
      const chartId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      // Build a descriptive label for the resources typed
      // e.g. "6000D, 7000E" or "6000D + 6000E" etc.
      const resourceDesc = resourceIdInput;
      // You could also note " (plus = combined)" if you want to be explicit

      // Now we inform the parent to create a chart with these lines
      onCreateChart({
        id: chartId,
        chartType,
        officeId,
        resourceId: resourceDesc, // keep the exact user input as "Resource" descriptor
        startDate,
        endDate,
        mergedData,
        resourceIDs,
      });

      setOpen(false);
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div 
      className={`${
        resolvedTheme == "light" 
         ? "bg-white border-gray-200" 
         : "bg-gray-1000 border-gray-1000"
        } border-r p-4 w-64 space-y-4`}
    >
      <h2 className="font-bold text-lg">Side Menu</h2>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="default">Create Chart</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Chart</DialogTitle>
            <DialogDescription>Select chart parameters</DialogDescription>
          </DialogHeader>

          {/* Chart Type (currently only "Line") */}
          <Label className="mt-4">Chart Type</Label>
          <select
            className="border p-1 rounded w-full"
            value={chartType}
            onChange={(e) => setChartType(e.target.value)}
          >
            <option value="Line">Line Chart</option>
            {/* Future: <option value="Pie">Pie Chart</option> etc. */}
          </select>

          {/* Office ID */}
          <Label className="mt-4">Office ID</Label>
          <Input
            type="text"
            value={officeId}
            onChange={(e) => setOfficeId(e.target.value)}
            placeholder="e.g. 10"
          />

          {/* Resource ID (comma/plus) */}
          <Label className="mt-4">Resource ID(s)</Label>
          <Input
            type="text"
            value={resourceIdInput}
            onChange={(e) => setResourceIdInput(e.target.value)}
            placeholder='e.g. "6000D+6000E, 5000E"'
          />
          <p className="text-xs text-muted-foreground mt-1">
            Use a comma (,) to create separate lines.  
            Use a plus (+) inside a group to combine data.
          </p>

          {/* Start/End Date */}
          <div className="mt-4 flex items-center gap-4">
            <div className="flex-1">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <Label>End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={loading || !officeId}>
              {loading ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
