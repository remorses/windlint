import React from 'react'

export function SocialButton({ brand }: { brand: string }) {
  return (
    <button
      className='flex items-center gap-2 rounded-lg px-4 py-2 text-social-apple bg-bg-white-0 hover:bg-bg-weak-50'
    >
      <span className='text-sm font-medium'>Continue with Apple</span>
    </button>
  )
}

export function SocialButtonFilled() {
  return (
    <button
      className='flex items-center gap-2 rounded-lg px-4 py-2 bg-social-apple text-white hover:bg-social-apple/90'
    >
      <span className='text-sm font-medium'>Sign in with Apple</span>
    </button>
  )
}

export function SocialButtonWithVariants() {
  return (
    <div>
      <button className='dark:text-social-apple focus:ring-social-apple border-social-apple'>
        Apple Button
      </button>
      <button className='text-social-twitter bg-social-twitter'>
        Twitter Button
      </button>
    </div>
  )
}
