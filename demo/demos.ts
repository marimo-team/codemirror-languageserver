import { mountMockDemo } from "./mock/mockDemo";
import { mountPythonDemo } from "./python/pythonDemo";
import { mountTypeScriptDemo } from "./typescript/tsDemo";

export interface Demo {
    id: string;
    label: string;
    /** Build the demo inside `container`; returns a dispose callback. */
    mount: (container: HTMLElement) => () => void;
}

export const DEMOS: Demo[] = [
    { id: "python", label: "Python · Ruff + ty", mount: mountPythonDemo },
    { id: "typescript", label: "TypeScript · vfs", mount: mountTypeScriptDemo },
    { id: "mock", label: "Mock · in-memory", mount: mountMockDemo },
];
