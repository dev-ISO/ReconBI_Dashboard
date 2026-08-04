/* eslint-disable @typescript-eslint/no-explicit-any */
// components/DynamicLineChartCard.tsx

"use client";

import React, { useMemo, useState, useEffect } from "react";
import axios from "axios";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { DraggableCard } from "./DraggableCard";
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
import { useTheme } from "next-themes";

/** 
 * MERGE FUNCTION
 * Merges multiple lines into a single chart data array.
 * Each "line" has data: [{ date: string; value: number }, ...],
 * stored under line.resourceId as dataKey in the final chart object.
 */
function mergeAllLines(lines: {
  resourceId: string;
  data: { date: string; value: number }[];
}[]): { [date: string]: any }[] {
  const dateMap: Record<string, Record<string, number>> = {};

  lines.forEach((line) => {
    line.data.forEach((entry) => {
      if (!dateMap[entry.date]) {
        dateMap[entry.date] = {};
      }
      // Use the resourceId as the "dataKey"
      dateMap[entry.date][line.resourceId] = entry.value;
    });
  });

  // Build sorted array
  const merged = Object.keys(dateMap)
    .sort()
    .map((date) => ({
      date,
      ...dateMap[date],
    }));

  return merged;
}

/** 
 * FETCH single resource data from the server.
 * Adjust IP/URL to your environment.
 */
async function fetchResourceData(officeId: string, resourceId: string) {
  // const api_url = "192.168.50.167";
  // const api_url = process.env.API_URL;
  // const api_port = process.env.API_PORT;

  // // const url = `http://${api_url}:${api_port}/api/data/offices/${officeId}/resources/${resourceId}`;
  // const url = `http://${process.env.NEXT_PUBLIC_API_URL}:${process.env.NEXT_PUBLIC_API_PORT}/api/data/offices/${officeId}/resources/${resourceId}`;
  // const response = await axios.get(url);

  const response = await axios.get(
    `/api/proxy?officeId=${officeId}&resourceId=${resourceId}`
  );

  // const response = await axios.get(
  //   url
  // );

  const dataArray = Array.isArray(response.data) ? response.data : [];
  // Typically dataArray = [ {office, resource, resourceID, data: [ {date, value} ] } ]
  // We only need the data array
  if (dataArray.length === 0) return [];
  return dataArray[0].data.map((d: any) => ({
    date: d.date,
    value: d.value,
  }));
}

/** 
 * COMBINE multiple resource data arrays into one "summed" line.
 * E.g. "6000D + 6000E" => for each date, sum their values.
 */
function combineResourceArrays(
  arraysOfData: { date: string; value: number }[][]
) {
  const dateMap: Record<string, number> = {};

  arraysOfData.forEach((arr) => {
    arr.forEach((entry) => {
      if (!dateMap[entry.date]) {
        dateMap[entry.date] = 0;
      }
      dateMap[entry.date] += entry.value;
    });
  });

  return Object.keys(dateMap)
    .sort()
    .map((date) => ({ date, value: dateMap[date] }));
}

/** 
 * PARSE a string like: "6000D+6000E,7000F"
 * => [ ["6000D","6000E"], ["7000F"] ]
 * Commas separate lines, plus signs combine resources for one line.
 */
function parseResourceInput(value: string): string[][] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((group) => group.split("+").map((r) => r.trim()).filter(Boolean));
}

/** 
 * GENERATE a random color each time (or implement stable/hsl as needed)
 */
function randomColor() {
  return (
    "#" +
    Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")
  );
}

interface ChartLine {
  resourceId: string; // e.g. "6000D" or "6000D+6000E"
  color: string;
  data: { date: string; value: number }[];
}

interface DynamicLineChartProps {
  id: string; // unique chart ID
  officeId: string;
  resourceId?: string; // initial user input
  mergedData: any[];   // initial merged data 
  resourceIDs: string[];
  startDate?: string;
  endDate?: string;
  onClose?: () => void;
}

export function DynamicLineChartCard({
  id,
  officeId,
  resourceId,
  mergedData,
  resourceIDs,
  startDate,
  endDate,
  onClose,
}: DynamicLineChartProps) {
  // lines in local state
  const [chartLines, setChartLines] = useState<ChartLine[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);

  // For toggling lines from the legend
  const [hiddenLines, setHiddenLines] = useState<Record<string, boolean>>({});

  // Modals
  const [enlargeOpen, setEnlargeOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  // For "Add Resource(s)" form
  const [newResourceId, setNewResourceId] = useState("");

  // INITIALIZE chartLines from existing mergedData + resourceIDs
  useEffect(() => {
    if (!mergedData || !resourceIDs) return;
    const initLines: ChartLine[] = resourceIDs.map((rid) => {
      const dataArr = mergedData.map((row: any) => ({
        date: row.date,
        value: row[rid] ?? 0,
      }));
      return { resourceId: rid, color: randomColor(), data: dataArr };
    });
    setChartLines(initLines);
  }, [mergedData, resourceIDs]);

  // Whenever chartLines changes, re-merge into chartData
  useEffect(() => {
    if (chartLines.length === 0) {
      setChartData([]);
      return;
    }
    const merged = mergeAllLines(chartLines);
    setChartData(merged);
  }, [chartLines]);

  // Format date + optional client-side date filtering
  const filteredData = useMemo(() => {
    if (!chartData || chartData.length === 0) return [];

    // Reformat date as "MM/DD/YY"
    const temp = chartData.map((item) => ({
      ...item,
      originalDate: item.date,
      date: new Date(item.date).toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "2-digit",
      }),
    }));

    if (!startDate && !endDate) return temp;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    return temp.filter((row) => {
      const d = new Date(row.originalDate);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [chartData, startDate, endDate]);

  function handleLegendClick(o: any) {
    const key = o.value; // resourceId
    setHiddenLines((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }

  /**
   * ADD LINES using the "newResourceId" input.
   * - Parse for commas/plus
   * - For each group => fetch single or combined
   * - Skip duplicates
   */
  async function handleAddLine(e: React.FormEvent) {
    e.preventDefault();
    const inputValue = newResourceId.trim();
    if (!inputValue) return;

    try {
      // e.g. "6000D+6000E,7000F" => [ ["6000D","6000E"], ["7000F"] ]
      const resourceGroups = parseResourceInput(inputValue);
      for (const group of resourceGroups) {
        if (group.length === 0) continue;
        let lineId = "";
        let finalData: { date: string; value: number }[] = [];

        if (group.length === 1) {
          // Single resource => fetch
          lineId = group[0];
          // Check for duplicate
          const alreadyExists = chartLines.some(
            (line) => line.resourceId === lineId
          );
          if (alreadyExists) {
            console.warn(`Line "${lineId}" already exists; skipping.`);
            continue;
          }
          const dataArr = await fetchResourceData(officeId, lineId);
          if (dataArr.length === 0) {
            console.warn(`No data returned for ${lineId}`);
            continue;
          }
          finalData = dataArr;
        } else {
          // e.g. user typed "6000D+6000E"
          lineId = group.join("+"); // e.g. "6000D+6000E"
          // check duplicate
          const alreadyExists = chartLines.some(
            (line) => line.resourceId === lineId
          );
          if (alreadyExists) {
            console.warn(`Line "${lineId}" already exists; skipping.`);
            continue;
          }
          // fetch each resource + sum
          const promises = group.map((resId) =>
            fetchResourceData(officeId, resId)
          );
          const results = await Promise.all(promises);
          // results is an array of arrays => combine
          const combined = combineResourceArrays(results);
          finalData = combined;
        }

        // Add new line
        setChartLines((prev) => [
          ...prev,
          {
            resourceId: lineId,
            color: randomColor(),
            data: finalData,
          },
        ]);
      }
      setNewResourceId("");
    } catch (err) {
      console.error("Error fetching resource(s):", err);
    }
  }

  // Remove a line by resourceId
  function handleRemoveLine(rid: string) {
    setChartLines((prev) => prev.filter((line) => line.resourceId !== rid));
  }

  // Update line color
  function handleColorChange(rid: string, color: string) {
    setChartLines((prev) =>
      prev.map((line) => {
        if (line.resourceId === rid) {
          return { ...line, color };
        }
        return line;
      })
    );
  }

  // Card Title & Description
  const cardTitle = `Line Chart: Office ${officeId}`;
  const cardDesc = resourceId
    ? `Resource(s): ${resourceId}`
    : "(All Resources)";

  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, [])

  if (!mounted)
  {
      return null;
  }

  // The main chart (used in normal + enlarged view)
  const ChartContent = (
    <>
      {filteredData.length > 0 ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={filteredData} margin={{top: 5, right: 5, left: 0, bottom: 30}}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              interval="preserveStartEnd"
              angle={-45}
              textAnchor="end"
              tickMargin={10}
              tick={{ fontSize: 11 }}
            />
            <YAxis />
            <Tooltip
              contentStyle={{
                backgroundColor: resolvedTheme === "dark" ? "#1a1a1a" : "#ffffff",
                borderColor: resolvedTheme === "dark" ? "#333333" : "#cccccc",
                color: resolvedTheme === "dark" ? "#ffffff" : "#000000",
              }}
            />
            <Legend 
              onClick={handleLegendClick}
              verticalAlign="top" 
              align="center"
              wrapperStyle={{ marginTop: 0 }}
            />
            {chartLines.map((line) => (
              <Line
                key={line.resourceId}
                type="monotone"
                dataKey={line.resourceId}
                name={line.resourceId}
                strokeWidth={2}
                stroke={line.color}
                dot={false}
                hide={!!hiddenLines[line.resourceId]}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          No Data
        </div>
      )}
    </>
  );

  return (
    <DraggableCard
      title={cardTitle}
      description={cardDesc}
      onClose={onClose}
      defaultWidth={600}
      defaultHeight={400}
      footer={
        <div className="flex gap-2">
          {/* Enlarge Chart Modal */}
          <Dialog open={enlargeOpen} onOpenChange={setEnlargeOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Enlarge Chart</Button>
            </DialogTrigger>
            <DialogContent className="max-w-8xl w-full">
              <DialogHeader>
                <DialogTitle>Enlarged Chart</DialogTitle>
                <DialogDescription>A bigger view of your chart</DialogDescription>
              </DialogHeader>
              <div className="w-full h-[80vh]">{ChartContent}</div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEnlargeOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Configure Modal */}
          <Dialog open={configOpen} onOpenChange={setConfigOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Configure</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Configure Chart</DialogTitle>
                <DialogDescription>
                  Change line colors, add or remove lines
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* Existing lines */}
                {chartLines.map((line) => (
                  <div key={line.resourceId} className="flex items-center gap-2">
                    <Label className="w-40">{line.resourceId}</Label>
                    <Input
                      type="color"
                      value={line.color}
                      onChange={(e) => handleColorChange(line.resourceId, e.target.value)}
                      className="h-8 w-12 p-0 border-none"
                    />
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleRemoveLine(line.resourceId)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}

                {/* Add new resource lines (commas => multiple, plus => combined) */}
                <form onSubmit={handleAddLine} className="flex items-center gap-2">
                  <Label className="w-40">Add Resource(s):</Label>
                  <Input
                    type="text"
                    value={newResourceId}
                    onChange={(e) => setNewResourceId(e.target.value)}
                    placeholder='e.g. "6000D+6000E, 5000D"'
                  />
                  <Button type="submit" variant="default">
                    Add
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground ml-[10rem]">
                  Use &quot;+&quot; to combine, &quot;, for multiple lines.  
                  e.g. 6000D+6000E, 7000D
                </p>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setConfigOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      }
    >
      <div className="w-full h-full">{ChartContent}</div>
    </DraggableCard>
  );
}
