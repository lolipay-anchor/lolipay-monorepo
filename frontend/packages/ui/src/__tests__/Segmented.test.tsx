import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Segmented } from '../Segmented'
describe('Segmented', () => {
  it('calls onChange with the clicked option', () => {
    const onChange = vi.fn()
    render(<Segmented options={['Buy','Sell','Pay QRIS']} value="Buy" onChange={onChange} />)
    fireEvent.click(screen.getByText('Sell'))
    expect(onChange).toHaveBeenCalledWith('Sell')
  })
})
