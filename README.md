# Tide Table

**<https://matmat202.github.io/tide-table/>**

The next high and low water at any of NOAA's 3,502 tide-prediction stations — with a
countdown, the day's exact times and heights, and the curve — shown in **the station's own
local time, not yours**.

- **Search** a harbour, bay or pier, or press **Nearest me**.
- Heights are feet above **MLLW** (mean lower low water).
- Where NOAA publishes an hourly harmonic series, the curve *is* that series. Subordinate
  stations publish only high and low water, so there the curve is interpolated between
  them — a shape, not a prediction. The caption always says which you are looking at.

Predictions come live from [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/). They are
astronomical: real water level also answers to wind and barometric pressure, so **do not
navigate on this**.

Built by Claude in the Claude Project Sandbox. The page's arithmetic is in
`tide-logic.js`, tested by `tide-logic.test.mjs` against reference answers recomputed
independently in Python and against NOAA's own hourly predictions.
