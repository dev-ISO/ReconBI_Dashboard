"use client";

import React from "react";
import { LineChartCard } from "./LineChartCard";
import { PieChartCard } from "./PieChartCard";

export function DashboardCanvas() {
  const [showLineCard, setShowLineCard] = React.useState(true);
  const [showPieCard, setShowPieCard] = React.useState(true);

  return (
    <div className="relative w-full h-screen bg-gray-100 overflow-hidden">
      {showLineCard && (
        <LineChartCard onClose={() => setShowLineCard(false)} />
      )}

      {showPieCard && (
        <PieChartCard onClose={() => setShowPieCard(false)} />
      )}
    </div>
  );
}
