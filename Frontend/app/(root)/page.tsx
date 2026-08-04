// app/page.tsx (or any route)
// Make sure "use client" if you're directly using states here.
"use client";

import React, { useState, useEffect } from "react";
import { SideMenu, ChartConfig } from "@/components/SideMenu";
import { DynamicLineChartCard } from "@/components/DynamicLineChartCard";
import { useTheme } from "next-themes";

export default function Home() {
  // We'll store each created chart in an array
  const [charts, setCharts] = useState<ChartConfig[]>([]);
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, [])

  if (!mounted)
  {
      return null;
  }


  // Callback from the side menu
  function handleCreateChart(config: ChartConfig) {
    setCharts((prev) => [...prev, config]);
  }

  // Remove a chart by ID when close is clicked
  function handleCloseChart(chartId: string) {
    setCharts((prev) => prev.filter((c) => c.id !== chartId));
  }

  return (
    <div className="flex w-full h-screen">
      {/* Side Menu */}
      <SideMenu onCreateChart={handleCreateChart} />

      {/* Draggable Charts Area */}
      
      <div 
        className={`flex-1 relative overflow-hidden ${
          resolvedTheme === "dark" 
          ? "bg-gray-900" 
          : "bg-gray-100"
        }`}
      >
        {charts.map((chart) => {
          if (chart.chartType === "Line") {
            return (
              <DynamicLineChartCard
                key={chart.id}
                id={chart.id}
                officeId={chart.officeId}
                resourceId={chart.resourceId}
                mergedData={chart.mergedData}
                resourceIDs={chart.resourceIDs}
                startDate={chart.startDate}
                endDate={chart.endDate}
                onClose={() => handleCloseChart(chart.id)}
              />
            );
          }
          // If you add more chart types later (Pie, Bar, etc.), handle them here
          return null;
        })}
      </div>
    </div>
  );
}
