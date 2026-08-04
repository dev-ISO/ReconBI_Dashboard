"use client";

import React from "react";
import { DraggableCard } from "./DraggableCard";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { ChartModal } from "./ChartModal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";

// Some sample data
const lineData = [
  { name: "A", uv: 4000, pv: 2400 },
  { name: "B", uv: 3000, pv: 1398 },
  { name: "C", uv: 2000, pv: 9800 },
  { name: "D", uv: 2780, pv: 3908 },
  { name: "E", uv: 1890, pv: 4800 },
  { name: "F", uv: 2390, pv: 3800 },
  { name: "G", uv: 3490, pv: 4300 },
];

interface LineChartCardProps {
  onClose?: () => void;
}

export function LineChartCard({ onClose }: LineChartCardProps) {
  // The chart content for the normal card view
  const lineChartContent = (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={lineData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="pv" stroke="#8884d8" />
        <Line type="monotone" dataKey="uv" stroke="#82ca9d" />
      </LineChart>
    </ResponsiveContainer>
  );

  // The enlarged chart in the modal can be the same content, but bigger container
  const enlargedLineChart = (
    <div className="w-full h-[50vh]"> 
      {/* or h-[70vh], etc. as you prefer */}
      {lineChartContent}
    </div>
  );

  const [open, setOpen] = React.useState(false);

  return (
    <DraggableCard
      title="Line Chart"
      description="Example line chart"
      defaultX={50}
      defaultY={50}
      defaultWidth={600}
      defaultHeight={500}
      minWidth={300}
      minHeight={200}
      onClose={onClose}
      footer={
        // Show a "Configure" or "Enlarge" button in the card footer
        <div className="space-x-2">
          <ChartModal 
            triggerText="Enlarge Chart"
            title="Line Chart (Enlarged)"
            description="A larger view of the line chart"
          >
            {enlargedLineChart}
          </ChartModal>
          {/* Add any other footer buttons or config modals here */}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Configure</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Configure Chart</DialogTitle>
                <DialogDescription>
                  Update chart settings here
                </DialogDescription>
              </DialogHeader>
              {/* Example form content or configuration fields */}
              <div className="space-y-2 my-4">
                <p>Your chart customization form goes here...</p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setOpen(false)}>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      }
    >
      {/* Normal card content (smaller chart) */}
      <div className="w-full h-full">{lineChartContent}</div>
    </DraggableCard>
  );
}
