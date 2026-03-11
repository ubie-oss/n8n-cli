export interface NodeDescriptionProperty {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ name: string; value: string | number | boolean }>;
  displayOptions?: {
    show?: Record<string, Array<string | number | boolean>>;
    hide?: Record<string, Array<string | number | boolean>>;
  };
}

export interface NodeDescription {
  nodeType: string;
  displayName: string;
  description: string;
  versions: number[];
  group: string[];
  inputs: string[];
  outputs: string[];
  usableAsTool?: boolean;
  credentials?: Array<{ name: string; required?: boolean }>;
  properties: NodeDescriptionProperty[];
}
