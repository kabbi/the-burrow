import { useState, type DragEvent } from "react";

export interface Dragged {
  id: string;
  parentId: string | null;
  name: string;
}

/** Drag state shared by the Places views: what is being dragged and where it can go. */
export interface Drag {
  dragging: Dragged | null;
  setDragging: (d: Dragged | null) => void;
  moveTo: (to: string | null, toName: string) => void;
}

/** Props that make a thing draggable for moving. */
export function dragSource(d: Dragged, drag: Drag) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", d.id);
      drag.setDragging(d);
    },
    onDragEnd: () => drag.setDragging(null),
  };
}

/**
 * Drop target for a place (`null` = "no place"). Inner targets stop the event so a row
 * inside a column doesn't also light up the column.
 */
export function useDrop(id: string | null, name: string, drag: Drag) {
  const [over, setOver] = useState(false);
  const can = Boolean(drag.dragging && drag.dragging.id !== id && drag.dragging.parentId !== id);
  return {
    over: over && can,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!can) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        if (!can) return;
        e.stopPropagation();
        drag.moveTo(id, name);
      },
    },
  };
}
