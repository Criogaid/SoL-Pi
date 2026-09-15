#!/usr/bin/env python3
"""Restyle the published Terminal-Bench 4 results to match the EdgeBench charts.

The numbers are copied from the existing website's 63-task evaluation; this
renderer does not recalculate model prices or experiment results.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MultipleLocator


ASSETS = Path(__file__).resolve().parents[1] / "assets"
HARNESSES = ("Codex", "Pi", "SoL-Pi")
COLORS = ("#B9B9B9", "#777777", "#76B900")
TEXT_COLOR = "#202020"
RESULTS = (
    ("success", (18, 18, 15), "Tasks solved (out of 63)", 22, 5),
    ("cost", (272.35, 286.45, 211.12), "Cost (USD)", 320, 100),
)


def main():
    # Match figures/results/plot_edgebench_web.py in the editable blog source.
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Helvetica Neue", "DejaVu Sans"],
        "font.size": 9.5,
        "axes.labelsize": 9.8,
        "xtick.labelsize": 8.5,
        "ytick.labelsize": 8.5,
        "axes.edgecolor": TEXT_COLOR,
        "axes.labelcolor": TEXT_COLOR,
        "xtick.color": TEXT_COLOR,
        "ytick.color": TEXT_COLOR,
        "svg.fonttype": "none",
        "svg.hashsalt": "sol-pi-terminal-bench-web",
    })

    for metric, values, ylabel, upper_limit, tick_step in RESULTS:
        fig, ax = plt.subplots(figsize=(4.8, 3.1))
        bars = ax.bar(range(3), values, width=0.58, color=COLORS,
                      edgecolor="white", linewidth=0.65, zorder=3)
        for harness, bar, value in zip(HARNESSES, bars, values):
            bar.set_gid(f"tb4-{metric}-{harness}")
            label = f"${value:,.2f}" if metric == "cost" else f"{value}/63"
            ax.annotate(label, (bar.get_x() + bar.get_width() / 2, value),
                        xytext=(0, 4), textcoords="offset points", ha="center",
                        va="bottom", fontsize=8.7, fontweight="bold", color=TEXT_COLOR)

        ax.set_xticks(range(3), HARNESSES)
        ax.set_xlim(-0.55, 2.55)
        ax.set_ylim(0, upper_limit)
        ax.set_ylabel(ylabel, labelpad=6)
        ax.yaxis.set_major_locator(MultipleLocator(tick_step))
        if metric == "cost":
            ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"${value:.0f}"))
        ax.set_axisbelow(True)
        ax.grid(axis="y", color="#D8DAD9", linewidth=0.7, linestyle=(0, (2, 2)))
        ax.grid(axis="x", visible=False)
        ax.spines[["top", "right"]].set_visible(False)
        ax.spines[["left", "bottom"]].set_linewidth(0.8)
        ax.tick_params(axis="x", length=0, pad=4)
        ax.tick_params(axis="y", length=2.5, width=0.7, pad=3)
        fig.subplots_adjust(left=0.16, right=0.99, bottom=0.115, top=0.975)
        fig.savefig(ASSETS / f"terminal-bench-4-{metric}.svg", facecolor="white",
                    metadata={"Date": None, "Title": f"Terminal-Bench 4: {ylabel}"})
        plt.close(fig)


if __name__ == "__main__":
    main()
