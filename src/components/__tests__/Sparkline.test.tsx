import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from '../Sparkline';

describe('<Sparkline />', () => {
  it('draws one line per series and an area when fill is set', () => {
    const { container } = render(
      <Sparkline
        label="test chart"
        times={[1000, 2000, 3000]}
        series={[
          { label: 'a', data: [1, 2, 3], color: 'red', fill: true },
          { label: 'b', data: [3, 2, 1], color: 'blue' },
        ]}
      />,
    );
    expect(container.querySelector('svg[aria-label="test chart"]')).toBeInTheDocument();
    expect(container.querySelectorAll('path')).toHaveLength(3); // 2 lines + 1 area
  });

  it('draws fault markers only inside the visible window', () => {
    const { container } = render(
      <Sparkline label="m" times={[100_000, 101_000]} marks={[100_500, 1_000]} series={[{ label: 'a', data: [1, 1], color: 'red' }]} />,
    );
    expect(container.querySelectorAll('line.mark')).toHaveLength(1);
  });

  it('skips series with fewer than two points', () => {
    const { container } = render(<Sparkline label="e" times={[1]} series={[{ label: 'a', data: [5], color: 'red' }]} />);
    expect(container.querySelectorAll('path')).toHaveLength(0);
  });
});
