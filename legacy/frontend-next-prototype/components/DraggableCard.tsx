// components/DraggableCard.tsx
"use client";

import React from "react";
import { Rnd } from "react-rnd";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface DraggableCardProps {
  title?: string;
  description?: string;
  defaultX?: number;
  defaultY?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  onClose?: () => void;       // Called when user clicks the close button
  footer?: React.ReactNode;   // Put extra buttons (e.g. “Configure”) here
  children?: React.ReactNode; // Chart or other content
}

export function DraggableCard({
  title = "Card Title",
  description = "",
  defaultX = 100,
  defaultY = 60,
  defaultWidth = 400,
  defaultHeight = 300,
  minWidth = 300,
  minHeight = 200,
  onClose,
  footer,
  children,
}: DraggableCardProps) {
  return (
    <Rnd
      default={{
        x: defaultX,
        y: defaultY,
        width: defaultWidth,
        height: defaultHeight,
      }}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="parent"
      className="shadow-lg"
    >
      <Card className="relative w-full h-full flex flex-col">
        {/* Close button pinned top-right */}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="absolute top-2 right-2"
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        <CardHeader>
          <h4 className="text-lg font-medium">
            {title}
          </h4>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </CardHeader>

        <CardContent className="flex-1 overflow-hidden">
          {children}
        </CardContent>

        {footer && <CardFooter className="flex justify-end">{footer}</CardFooter>}
      </Card>
    </Rnd>
  );
}
