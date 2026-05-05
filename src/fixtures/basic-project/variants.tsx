import { tv } from 'tailwind-variants'

export const socialButtonVariants = tv({
  base: 'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium',
  variants: {
    mode: {
      stroke: 'bg-white ring-1 ring-inset ring-stroke-soft-200',
      filled: 'text-white',
    },
  },
  compoundVariants: [
    {
      brand: 'apple',
      mode: 'stroke',
      class: 'text-social-apple hover:bg-social-apple/5',
    },
    {
      brand: 'apple',
      mode: 'filled',
      class: 'bg-social-apple hover:bg-social-apple/90',
    },
    {
      brand: 'twitter',
      mode: 'stroke',
      class: 'text-social-twitter hover:bg-social-twitter/5',
    },
  ],
})

export function InlineStyleExample() {
  return (
    <div style={{ color: 'var(--color-social-apple)' }}>
      Inline style with var reference
    </div>
  )
}
