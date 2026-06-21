import { Minus, Plus } from "lucide-react";

type SettingStepperProps = {
  label: string;
  description: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

function stepNumber(value: number, step: number, direction: -1 | 1) {
  return Math.round((value + step * direction) * 100) / 100;
}

export function SettingStepper({
  label,
  description,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: SettingStepperProps) {
  const commit = (next: number) => {
    onChange(Math.max(min, Math.min(max, next)));
  };

  return (
    <div className="settings-field">
      <div className="settings-label">
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <div className="number-stepper">
        <button type="button" onClick={() => commit(stepNumber(value, step, -1))} aria-label={`Decrease ${label}`}>
          <Minus size={14} />
        </button>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => commit(Number(event.currentTarget.value))}
          aria-label={label}
        />
        <button type="button" onClick={() => commit(stepNumber(value, step, 1))} aria-label={`Increase ${label}`}>
          <Plus size={14} />
        </button>
        <small>{unit}</small>
      </div>
    </div>
  );
}
