/**
 * Folds eve's `reasoning.appended` / `reasoning.completed` events for ONE turn into the turn's
 * visible reasoning text. Shared by the live stream and the replay projection so both render the
 * same thing. A turn can hold several reasoning blocks (one or more per step); blocks are joined
 * with a blank line. `appended` carries the block's cumulative text so far; `completed` the final
 * block text — either can arrive without the other.
 */
export class ReasoningAccumulator {
  private blocks: string[] = [];
  private open = false;

  /** Returns true when the visible text changed. */
  apply(type: string, data: Record<string, unknown>): boolean {
    const before = this.text();
    if (type === "reasoning.appended") {
      const soFar =
        typeof data.reasoningSoFar === "string"
          ? data.reasoningSoFar
          : typeof data.reasoningDelta === "string"
            ? (this.open ? this.blocks.at(-1)! : "") + data.reasoningDelta
            : null;
      if (soFar === null) return false;
      if (this.open) this.blocks[this.blocks.length - 1] = soFar;
      else {
        this.blocks.push(soFar);
        this.open = true;
      }
    } else if (type === "reasoning.completed") {
      const final = typeof data.reasoning === "string" ? data.reasoning : null;
      if (this.open) {
        if (final !== null) this.blocks[this.blocks.length - 1] = final;
        this.open = false;
      } else if (final !== null) {
        this.blocks.push(final);
      }
    } else {
      return false;
    }
    return this.text() !== before;
  }

  text(): string | null {
    const joined = this.blocks
      .map((b) => b.trim())
      .filter(Boolean)
      .join("\n\n");
    return joined || null;
  }
}
