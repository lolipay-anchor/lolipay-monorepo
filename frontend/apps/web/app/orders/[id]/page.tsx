import * as React from 'react'
import { OrderStatus } from '@/components/OrderStatus'

interface Props {
  params: Promise<{ id: string }>
}

export default async function OrderPage({ params }: Props) {
  const { id } = await params
  return <OrderStatus id={id} />
}
