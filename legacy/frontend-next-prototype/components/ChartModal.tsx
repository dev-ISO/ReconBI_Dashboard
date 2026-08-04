"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// We pass in "triggerText" (label of the button) and the chart "children"
interface ChartModalProps {
  triggerText?: string;
  title?: string;
  description?: string;
  children: React.ReactNode;
}

export function ChartModal({
  triggerText = "Open Chart",
  title = "Enlarged Chart",
  description = "A larger view of the chart",
  children,
}: ChartModalProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">{triggerText}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl"> 
        {/* Adjust width or use w-full/h-full with a max constraint */}
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children /* The chart or content to display in large view */}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
