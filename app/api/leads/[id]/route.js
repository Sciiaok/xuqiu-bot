// app/api/leads/[id]/route.js
import { NextResponse } from 'next/server';
import { getLeadById, updateLeadFields } from '@/lib/repositories/lead.repository';

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const lead = await getLeadById(id);

    if (!lead) {
      return NextResponse.json(
        { success: false, error: 'Lead not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error('Error fetching lead:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const lead = await updateLeadFields(id, body);

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error('Error updating lead:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
