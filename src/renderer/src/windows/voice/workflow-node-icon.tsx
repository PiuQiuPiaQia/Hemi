import {
  SlidersHorizontal,
  SquareMousePointer,
  Sparkles,
  Globe,
  Monitor,
  GitBranch,
  UserCheck,
  PackageCheck,
} from "lucide-react";

/** One icon vocabulary for the editor, inspector and read-only process. */
export const WORKFLOW_NODE_ICONS = {
  "hemi-input": SlidersHorizontal,
  "hemi-agent": SquareMousePointer,
  "hemi-skill": Sparkles,
  "hemi-browser": Globe,
  "hemi-desktop": Monitor,
  "hemi-condition": GitBranch,
  "hemi-human-input": UserCheck,
  "hemi-deliver": PackageCheck,
} as const;
