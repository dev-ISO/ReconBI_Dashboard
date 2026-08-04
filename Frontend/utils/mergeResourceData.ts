/* eslint-disable @typescript-eslint/no-explicit-any */
// utils/mergeResourceData.ts

/**
 * Takes an array of objects like:
 * [
 *   {
 *     resourceID: "3000E",
 *     data: [ { date: "2021-01-01", value: 123 }, ...],
 *     ...
 *   },
 *   ...
 * ]
 * and merges them into a single array keyed by date.
 */
export function mergeResourceData(items: any[]) {
    const dateMap: Record<string, Record<string, number>> = {};
    const resourceIDs: Set<string> = new Set();
  
    items.forEach((item) => {
      const resourceId = item.resourceID;
      resourceIDs.add(resourceId);
  
      item.data.forEach((entry: { date: string; value: number }) => {
        if (!dateMap[entry.date]) {
          dateMap[entry.date] = {};
        }
        dateMap[entry.date][resourceId] = entry.value;
      });
    });
  
    const mergedData = Object.keys(dateMap)
      .sort() // ascending date order if "YYYY-MM-DD"
      .map((date) => ({
        date,
        ...dateMap[date],
      }));
  
    return {
      mergedData,
      resourceIDs: Array.from(resourceIDs),
    };
  }
  
  