// Heuristic entry-level filter for medical/research roles.
// Hard-block clinical / nurse / specialist roles.
const HARD_EXCLUDE =
  /\b(nurse|nursing|\brn\b|registered nurse|nurse practitioner|\bnp\b|\blpn\b|\bcna\b|physician assistant|\bpa\b|practitioner|technologist|sonographer|radiology|imaging|infusion|anesthesi\w*|anesthetist|crna|surgical tech|ultrasound|specialists?|pharmacist|dietitian|nutritionist|therapist|psychometrist|secretary|mechanic|maintenance|develop\w*|broker|gift\w*|marketing|cybersecurity|datawarehouse|finance|accountant|compliance|liaison|risk|policy)\b/i;

const INCLUDE =
  /\b(assistant|coordinator|technician|tech|intern|trainee|entry[-\s]?level|junior|associate|fellow|analyst|scribe|aide|apprentice|scholar|postbac|post[-\s]?bac|study coord)\b/i;

const LEVEL_ONE = /\b(I|1)\b(?!\w)/;

const EXCLUDE =
  /\b(senior|sr\.?|director|chief|head|principal|lead|manager|mgr|supervisor|vp|vice president|executive|professor|attending|consultant|advanced|expert)\b/i;

const LEVEL_MID = /\b(II|III|IV|V|VI|VII|2|3|4|5)\b(?!\w)/;

const RESEARCH =
  /\b(research|clinical|lab|laboratory|biostatist|bioinformatic|data|study|trial|genomic|genetic|epidemiolog|biolog|chem|pharmac|neuro|cancer|onco)\b/i;

export function isEntryLevelResearch(title: string): boolean {
  if (!title) return false;
  if (HARD_EXCLUDE.test(title)) return false;
  if (EXCLUDE.test(title)) return false;
  if (LEVEL_MID.test(title)) return false;
  if (!RESEARCH.test(title)) return false;
  if (INCLUDE.test(title)) return true;
  if (LEVEL_ONE.test(title)) return true;
  return false;
}
