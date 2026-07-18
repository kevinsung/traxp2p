export interface LogoProps {
  small?: boolean
}

/** The "TRAX" wordmark, white for TR and red for AX to match the two track colors. */
export function Logo({ small }: LogoProps) {
  return (
    <h1 className={small ? 'logo small' : 'logo'}>
      <span className="logo-w">TR</span>
      <span className="logo-r">AX</span>
    </h1>
  )
}
