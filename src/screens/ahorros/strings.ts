// Textos propios de la hoja "Savings" en los tres idiomas. Los comunes (Add, Delete, Edit, Save, Cancel, Date,
// Goal, Amount, Month, Rate, Cur.…) salen de useI18n().t; los nombres de las metas son datos del usuario y no se traducen.
//
// Los títulos y encabezados comunes (Income by month, Saved, % saved, Add income, Account…) también son de useI18n().t.
// Las monedas van siempre como código ({currency}: DOP, USD, TRY), igual en los tres idiomas.
//
// Turco: con los términos acordados (Katkılar, Hedef, Gelir, Kur…); pendiente de revisión por un hablante nativo.

import { defineStrings } from '../../i18n';

export const AHORROS = defineStrings({
  en: {
    // ── Tarjetas de metas ────────────────────────────────────────────────────
    kindVariable: 'Variable contributions',
    kindMonthly: '{amount} {currency} / month',
    progress: '{pct}% of {target} {currency}',
    progressOf: 'Progress toward {name}',
    deadline: 'Target: {month}',
    recorded: { one: '{count} contribution recorded', other: '{count} contributions recorded' },
    left: {
      one: '{count} contribution left · {amount} {currency} per month to get there',
      other: '{count} contributions left · {amount} {currency} per month to get there',
    },
    reached: 'Target reached',
    passed: 'Target month passed · {amount} {currency} to go',
    editGoalNamed: 'Edit {name}',
    addGoal: 'Add goal',

    // ── Diálogo de una meta ──────────────────────────────────────────────────
    newGoal: 'New goal',
    editGoal: 'Edit goal',
    name: 'Name',
    approxCurrency: 'Show equivalent in',
    hasTarget: 'This goal has a target',
    targetAmount: 'Target amount ({currency})',
    startMonth: 'Start month',
    targetMonth: 'Target month',
    monthlySaving: 'Monthly saving ({currency})',
    planSummary: { one: '{count} month · {amount} {currency} / month', other: '{count} months · {amount} {currency} / month' },
    deleteGoal: 'Delete goal',
    deleteGoalBlocked: { one: 'Delete its {count} contribution first', other: 'Delete its {count} contributions first' },
    errorName: 'Enter a name.',
    errorNameTaken: 'Another goal already has this name.',
    errorAmount: 'Enter an amount greater than 0.',
    errorMonths: 'The target month cannot be before the start month.',

    // ── Ingresos por mes ─────────────────────────────────────────────────────
    incomeNote: "In {currency}, at each month's rate",

    // ── Ingresos, uno por uno ────────────────────────────────────────────────
    incomesTitle: 'Income',
    incomeDate: 'Income date',
    incomeDescPlaceholder: 'Salary, payment…',
    deleteIncome: 'Delete income of {date}: {amount} {cur}',
    incomeBudgetOf: 'Adds to budget: income of {date}, {amount} {cur}',
    newIncomeBudget: 'The new income adds to the budget',
    recurring: 'Recurring',
    incomeRecurringOf: 'Recurring: income of {date}, {amount} {cur}',
    newIncomeRecurring: 'The new income repeats every month',
    incomeMonth: 'Income month',
    shortLine: '{description}: {account} has {available} {cur} left, so nothing remains of this income, yet it adds {amount} {cur} to the budget.',
    shortLineNone: '{description}: {account} has no money left, so nothing remains of this income, yet it adds {amount} {cur} to the budget.',
    shortAdvice: 'Untick "Adds to budget" or use "+ Extra budget" with only the amount that remains.',
    shortRemove: 'Remove from budget',
    shortListLabel: 'Incomes that add more to the budget than the account holds',
    shortRemoveOf: 'Remove {description} from the budget',

    // ── Aportes ──────────────────────────────────────────────────────────────
    contribsTitle: 'Contributions',
    inGoal: 'In goal',
    contribDate: 'Contribution date',
    fromAccount: 'From account',
    noAccount: '— none —',
    deleteContrib: 'Delete contribution of {date} to {goal}: {amount} {cur}',
    noGoals: 'Add a goal first to record contributions.',
    addContribution: 'Add contribution',

    // ── Tasas ────────────────────────────────────────────────────────────────
    rateManual: 'Manual',
    rateOf: 'Rate: {currency} per 1 {from}',
    // Al pie de una tabla con alguna cifra convertida con la tasa fija de respaldo (marcada con *).
    fallbackNote: '* Converted with a default rate that has not been set yet.',
  },

  es: {
    kindVariable: 'Aportes variables',
    kindMonthly: '{amount} {currency} / mes',
    progress: '{pct}% de {target} {currency}',
    progressOf: 'Progreso de {name}',
    deadline: 'Meta: {month}',
    recorded: { one: '{count} aporte registrado', other: '{count} aportes registrados' },
    left: {
      one: 'Falta {count} aporte · {amount} {currency} por mes para llegar',
      other: 'Faltan {count} aportes · {amount} {currency} por mes para llegar',
    },
    reached: 'Meta alcanzada',
    passed: 'El mes objetivo ya pasó · faltan {amount} {currency}',
    editGoalNamed: 'Editar {name}',
    addGoal: 'Agregar meta',

    newGoal: 'Nueva meta',
    editGoal: 'Editar meta',
    name: 'Nombre',
    approxCurrency: 'Mostrar equivalente en',
    hasTarget: 'Esta meta tiene un objetivo',
    targetAmount: 'Monto objetivo ({currency})',
    startMonth: 'Mes de inicio',
    targetMonth: 'Mes objetivo',
    monthlySaving: 'Ahorro mensual ({currency})',
    planSummary: { one: '{count} mes · {amount} {currency} / mes', other: '{count} meses · {amount} {currency} / mes' },
    deleteGoal: 'Eliminar meta',
    deleteGoalBlocked: { one: 'Elimina primero su {count} aporte', other: 'Elimina primero sus {count} aportes' },
    errorName: 'Escribe un nombre.',
    errorNameTaken: 'Ya hay otra meta con ese nombre.',
    errorAmount: 'Escribe un monto mayor que 0.',
    errorMonths: 'El mes objetivo no puede ser anterior al mes de inicio.',

    incomeNote: 'En {currency}, a la tasa de cada mes',

    incomesTitle: 'Ingresos',
    incomeDate: 'Fecha del ingreso',
    incomeDescPlaceholder: 'Sueldo, pago…',
    deleteIncome: 'Eliminar ingreso del {date}: {amount} {cur}',
    incomeBudgetOf: 'Suma al presupuesto: ingreso del {date}, {amount} {cur}',
    newIncomeBudget: 'El ingreso nuevo suma al presupuesto',
    recurring: 'Recurrente',
    incomeRecurringOf: 'Recurrente: ingreso del {date}, {amount} {cur}',
    newIncomeRecurring: 'El ingreso nuevo se repite cada mes',
    incomeMonth: 'Mes de los ingresos',
    shortLine: '{description}: {account} solo tiene {available} {cur} disponible, así que de este ingreso solo queda eso, pero aun así suma {amount} {cur} al presupuesto.',
    shortLineNone: '{description}: {account} no tiene dinero disponible, así que de este ingreso no queda nada, pero aun así suma {amount} {cur} al presupuesto.',
    shortAdvice: 'Desmarca «Suma al presupuesto» o usa «+ Presupuesto extra» solo con lo que queda.',
    shortRemove: 'Quitar del presupuesto',
    shortListLabel: 'Ingresos que suman al presupuesto más de lo que tiene la cuenta',
    shortRemoveOf: 'Quitar {description} del presupuesto',

    contribsTitle: 'Aportes',
    inGoal: 'En la meta',
    contribDate: 'Fecha del aporte',
    fromAccount: 'Desde cuenta',
    noAccount: '— ninguna —',
    deleteContrib: 'Eliminar aporte del {date} a {goal}: {amount} {cur}',
    noGoals: 'Agrega primero una meta para registrar aportes.',
    addContribution: 'Agregar aporte',

    rateManual: 'Manual',
    rateOf: 'Tasa: {currency} por 1 {from}',
    fallbackNote: '* Convertido con una tasa por defecto, aún sin definir.',
  },

  tr: {
    kindVariable: 'Değişken katkılar',
    kindMonthly: '{amount} {currency} / ay',
    // En turco el signo de porcentaje va delante de la cifra (%20).
    progress: '%{pct} / {target} {currency}',
    progressOf: '{name} ilerlemesi',
    deadline: 'Hedef: {month}',
    // El sustantivo no cambia después de un número: las dos formas son iguales.
    recorded: { one: '{count} katkı kaydedildi', other: '{count} katkı kaydedildi' },
    left: {
      one: '{count} katkı kaldı · hedefe ulaşmak için ayda {amount} {currency}',
      other: '{count} katkı kaldı · hedefe ulaşmak için ayda {amount} {currency}',
    },
    reached: 'Hedefe ulaşıldı',
    passed: 'Hedef ay geçti · {amount} {currency} kaldı',
    editGoalNamed: 'Düzenle: {name}',
    addGoal: 'Hedef ekle',

    newGoal: 'Yeni hedef',
    editGoal: 'Hedefi düzenle',
    name: 'Ad',
    approxCurrency: 'Karşılığını göster',
    hasTarget: 'Bu hedefin belirli bir tutarı ve tarihi var',
    targetAmount: 'Hedef tutar ({currency})',
    startMonth: 'Başlangıç ayı',
    targetMonth: 'Hedef ay',
    monthlySaving: 'Aylık birikim ({currency})',
    planSummary: { one: '{count} ay · {amount} {currency} / ay', other: '{count} ay · {amount} {currency} / ay' },
    deleteGoal: 'Hedefi sil',
    deleteGoalBlocked: { one: 'Önce {count} katkısını silin', other: 'Önce {count} katkısını silin' },
    errorName: 'Bir ad girin.',
    errorNameTaken: 'Bu adda başka bir hedef var.',
    errorAmount: "0'dan büyük bir tutar girin.",
    errorMonths: 'Hedef ay, başlangıç ayından önce olamaz.',

    incomeNote: '{currency} cinsinden, her ayın kuruyla',

    incomesTitle: 'Gelirler',
    incomeDate: 'Gelir tarihi',
    incomeDescPlaceholder: 'Maaş, ödeme…',
    deleteIncome: '{date} tarihli geliri sil: {amount} {cur}',
    incomeBudgetOf: 'Bütçeye eklenir: {date} geliri, {amount} {cur}',
    newIncomeBudget: 'Yeni gelir bütçeye eklenir',
    recurring: 'Düzenli',
    incomeRecurringOf: 'Düzenli: {date} geliri, {amount} {cur}',
    newIncomeRecurring: 'Yeni gelir her ay tekrarlanır',
    incomeMonth: 'Gelir ayı',
    shortLine: '{description}: {account} hesabında yalnızca {available} {cur} kaldı; bu gelirden yalnızca o kadar kaldı, yine de bütçeye {amount} {cur} ekliyor.',
    shortLineNone: '{description}: {account} hesabında para kalmadı; bu gelirden hiçbir şey kalmadı, yine de bütçeye {amount} {cur} ekliyor.',
    shortAdvice: '"Bütçeye eklenir" işaretini kaldırın veya "+ Ek bütçe"yi yalnızca kalan tutarla kullanın.',
    shortRemove: 'Bütçeden çıkar',
    shortListLabel: 'Bütçeye hesabın tuttuğundan fazlasını ekleyen gelirler',
    shortRemoveOf: '{description} gelirini bütçeden çıkar',

    contribsTitle: 'Katkılar',
    inGoal: 'Hedefte',
    contribDate: 'Katkı tarihi',
    fromAccount: 'Hesaptan',
    noAccount: '— yok —',
    deleteContrib: '{date} tarihli {goal} katkısını sil: {amount} {cur}',
    noGoals: 'Katkı kaydetmek için önce bir hedef ekleyin.',
    addContribution: 'Katkı ekle',

    rateManual: 'Manuel',
    rateOf: 'Kur: 1 {from} için {currency}',
    fallbackNote: '* Henüz girilmemiş, varsayılan bir kurla çevrildi.',
  },
});
