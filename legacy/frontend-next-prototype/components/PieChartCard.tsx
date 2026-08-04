"use client";

import React from "react";
import { DraggableCard } from "./DraggableCard";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
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

// Sample data for the pie chart
const pieData = [
  { name: "Group A", value: 400 },
  { name: "Group B", value: 300 },
  { name: "Group C", value: 300 },
  { name: "Group D", value: 200 },
];

const COLORS = ["#0088FE", "#00C49F", "#FFBB28", "#FF8042"];

interface PieChartCardProps {
  onClose?: () => void;
}

export function PieChartCard({ onClose }: PieChartCardProps) {
  const pieChartContent = (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={pieData}
          cx="50%"
          cy="50%"
          outerRadius={80}
          fill="#8884d8"
          dataKey="value"
          label
        >
          {pieData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );

  const enlargedPieChart = (
    <div className="w-full h-[50vh]">
      {pieChartContent}
    </div>
  );

  const [open, setOpen] = React.useState(false);

  return (
    <DraggableCard
      title="Pie Chart"
      description="Example pie chart"
      defaultX={700}
      defaultY={50}
      defaultWidth={400}
      defaultHeight={400}
      minWidth={400}
      minHeight={400}
      onClose={onClose}
      footer={
        <div className="space-x-2">
          <ChartModal 
            triggerText="Enlarge Chart"
            title="Pie Chart (Enlarged)"
            description="A larger view of the pie chart"
          >
            {enlargedPieChart}
          </ChartModal>
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
      <div className="w-full h-full">{pieChartContent}</div>
    </DraggableCard>
  );
}
