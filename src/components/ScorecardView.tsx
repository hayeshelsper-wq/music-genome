// The per-dimension scorecard bars — shared by the one-shot result card and
// every optimizer-loop attempt card. Extracted verbatim from GenomeStudio.

export interface DimScore {
  label: string;
  target: string;
  achieved: string;
  score: number;
  detail?: string;
}

export interface ScorecardData {
  overall: number;
  dims: DimScore[];
  clap: number | null;
}

export function scoreColor(s: number): string {
  if (s >= 75) return "var(--influence)";
  if (s >= 45) return "var(--root)";
  return "var(--descendant)";
}

export default function ScorecardView({ dims }: { dims: DimScore[] }) {
  return (
    <table className="studio-table">
      <thead>
        <tr>
          <th>Dimension</th>
          <th>Target</th>
          <th>Generated</th>
          <th>Match</th>
        </tr>
      </thead>
      <tbody>
        {dims.map((d) => (
          <tr key={d.label}>
            <td>{d.label}</td>
            <td>{d.target}</td>
            <td>{d.achieved}</td>
            <td>
              <div className="studio-bar-wrap">
                <div
                  className="studio-bar"
                  style={{ width: `${d.score}%`, background: scoreColor(d.score) }}
                />
                <span>{d.score}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
